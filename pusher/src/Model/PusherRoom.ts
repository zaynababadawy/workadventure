import { ExSocketInterface } from "../Model/Websocket/ExSocketInterface";
import { PositionDispatcher } from "./PositionDispatcher";
import { ViewportInterface } from "../Model/Websocket/ViewportMessage";
import { ZoneEventListener } from "../Model/Zone";
import { apiClientRepository } from "../Services/ApiClientRepository";
import {
    BatchToPusherRoomMessage,
    ErrorMessage,
    RoomMessage,
    SubChatMessage,
    SubMessage,
    VariableWithTagMessage,
} from "../Messages/generated/messages_pb";
import Debug from "debug";
import { ClientReadableStream } from "@grpc/grpc-js";

const debug = Debug("room");

export class PusherRoom {
    private readonly positionNotifier: PositionDispatcher;
    private versionNumber = 1;
    //eslint-disable-next-line @typescript-eslint/no-explicit-any
    public mucRooms: Array<any> = [];

    private backConnection!: ClientReadableStream<BatchToPusherRoomMessage>;
    private isClosing = false;
    private listeners: Set<ExSocketInterface> = new Set<ExSocketInterface>();
    private listenersChat: Set<ExSocketInterface> = new Set<ExSocketInterface>();

    constructor(public readonly roomUrl: string, private socketListener: ZoneEventListener) {
        // A zone is 10 sprites wide.
        this.positionNotifier = new PositionDispatcher(this.roomUrl, 320, 320, this.socketListener);

        // By default, create a MUC room whose name is the name of the room.
        this.mucRooms = [
            {
                name: "Connected users",
                uri: roomUrl,
            },
        ];
    }

    public setViewport(socket: ExSocketInterface, viewport: ViewportInterface): void {
        this.positionNotifier.setViewport(socket, viewport);
    }

    public join(socket: ExSocketInterface): void {
        this.listeners.add(socket);

        if (!this.mucRooms) {
            return;
        }

        //socket.xmppClient = new XmppClient(socket, this.mucRooms);
        socket.pusherRoom = this;
    }

    public joinChat(socket: ExSocketInterface): void {
        this.listenersChat.add(socket);
        socket.pusherRoom = this;
    }

    public leaveChat(socket: ExSocketInterface): void {
        this.listenersChat.delete(socket);
        socket.pusherRoom = undefined;
    }

    public leave(socket: ExSocketInterface): void {
        this.positionNotifier.removeViewport(socket);
        this.listeners.delete(socket);
        if (socket.xmppClient) {
            socket.xmppClient.close();
        }
        socket.pusherRoom = undefined;
    }

    public isEmpty(): boolean {
        if (this.listenersChat.size === 0 && this.listeners.size === 0 && !this.positionNotifier.isEmpty()) {
            console.error("PusherRoom => positionNotifier not empty but no listeners registered !");
        }
        return this.listenersChat.size === 0 && this.listeners.size === 0;
    }

    public needsUpdate(versionNumber: number): boolean {
        if (this.versionNumber < versionNumber) {
            this.versionNumber = versionNumber;
            return true;
        } else {
            return false;
        }
    }

    /**
     * Creates a connection to the back server to track global messages relative to this room (like variable changes).
     */
    public async init(): Promise<void> {
        debug("Opening connection to room %s on back server", this.roomUrl);
        const apiClient = await apiClientRepository.getClient(this.roomUrl);
        const roomMessage = new RoomMessage();
        roomMessage.setRoomid(this.roomUrl);
        this.backConnection = apiClient.listenRoom(roomMessage);
        this.backConnection.on("data", (batch: BatchToPusherRoomMessage) => {
            for (const message of batch.getPayloadList()) {
                if (message.hasVariablemessage()) {
                    const variableMessage = message.getVariablemessage() as VariableWithTagMessage;
                    const readableBy = variableMessage.getReadableby();

                    // We need to store all variables to dispatch variables later to the listeners
                    //this.variables.set(variableMessage.getName(), variableMessage.getValue(), readableBy);

                    // Let's dispatch this variable to all the listeners
                    for (const listener of this.listeners) {
                        if (!readableBy || listener.tags.includes(readableBy)) {
                            const subMessage = new SubMessage();
                            subMessage.setVariablemessage(variableMessage);
                            listener.emitInBatch(subMessage);
                        }
                    }
                } else if (message.hasEditmapcommandmessage()) {
                    for (const listener of this.listeners) {
                        const subMessage = new SubMessage();
                        subMessage.setEditmapcommandmessage(message.getEditmapcommandmessage());
                        listener.emitInBatch(subMessage);
                    }
                } else if (message.hasErrormessage()) {
                    const errorMessage = message.getErrormessage() as ErrorMessage;

                    // Let's dispatch this error to all the listeners
                    for (const listener of this.listeners) {
                        const subMessage = new SubMessage();
                        subMessage.setErrormessage(errorMessage);
                        listener.emitInBatch(subMessage);
                    }
                } else if (message.hasJoinmucroommessage()) {
                    // Let's dispatch this joinMucRoomMessage to all the listeners
                    for (const listener of this.listenersChat) {
                        const subChatMessage = new SubChatMessage();
                        subChatMessage.setJoinmucroommessage(message.getJoinmucroommessage());
                        listener.emitInBatch(subChatMessage);
                    }
                    console.log("===> JOINMUCROOMMESSAGE received");
                } else if (message.hasLeavemucroommessage()) {
                    // Let's dispatch this leaveMucRoomMessage to all the listeners
                    for (const listener of this.listenersChat) {
                        const subChatMessage = new SubChatMessage();
                        subChatMessage.setLeavemucroommessage(message.getLeavemucroommessage());
                        listener.emitInBatch(subChatMessage);
                    }
                    console.log("===> LEAVEMUCROOMMESSAGE received");
                } else {
                    throw new Error("Unexpected message");
                }
            }
        });

        this.backConnection.on("error", (err) => {
            if (!this.isClosing) {
                debug("Error on back connection");
                this.close();
                // Let's close all connections linked to that room
                for (const listener of this.listeners) {
                    listener.disconnecting = true;
                    listener.end(1011, "Connection error between pusher and back server");
                    console.error("Connection error between pusher and back server", err);
                }
            }
        });
        this.backConnection.on("close", () => {
            if (!this.isClosing) {
                debug("Close on back connection");
                this.close();
                // Let's close all connections linked to that room
                for (const listener of this.listeners) {
                    listener.disconnecting = true;
                    listener.end(1011, "Connection closed between pusher and back server");
                }
            }
        });
    }

    public close(): void {
        debug("Closing connection to room %s on back server", this.roomUrl);
        this.isClosing = true;
        this.backConnection.cancel();

        debug("Closing connections to XMPP server for room %s", this.roomUrl);
        for (const client of this.listeners) {
            client.xmppClient?.close();
        }
    }
}
