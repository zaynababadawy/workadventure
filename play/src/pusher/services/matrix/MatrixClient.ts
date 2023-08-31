import * as sdk from "matrix-js-sdk";

export class MatrixClient {
    /**
     * Create a matrix client
     *  exemple user id: "@example:localhost";
     *  exemple access token: "QGV4YW1wbGU6bG9jYWxob3N0.qPEvLuYfNBjxikiCjP";
     *
     * @param myUserId
     * @param myAccessToken
     * @param baseUrl
     */

    private matrixClient: sdk.MatrixClient;

    constructor(private userId: string, private accessToken: string, private baseUrl: string) {
        this.matrixClient = sdk.createClient({
            baseUrl,
            accessToken,
            userId,
        });
        // init the matrix client
        this.init();
    }

    // init the matrix client
    init() {
        // join the rooms
        // @ts-ignore
        this.matrixClient.on("RoomMember.membership", (event, member) => {
            if (member.membership === "invite" && member.userId === this.userId) {
                this.matrixClient
                    .joinRoom(member.roomId)
                    .then(() => {
                        console.log("Auto-joined %s", member.roomId);
                    })
                    .catch((err) => {
                        console.info("Failed to join %s", member.roomId, err);
                    });
            }
        });

        // print the message
        // @ts-ignore
        this.matrixClient.on("Room.timeline", (event, room, toStartOfTimeline) => {
            if (toStartOfTimeline) {
                return; // don't print paginated results
            }
            console.log("(%s) => %s", room.name, event.getType(), event.getContent());
            if (event.getType() !== "m.room.message") {
                return; // only print messages
            }
            console.log(
                // the room name will update with m.room.name events automatically
                "(%s) %s :: %s",
                room.name,
                event.getSender(),
                event.getContent().body
            );
        });

        // print the room members
        // @ts-ignore
        this.matrixClient.on("RoomState.members", (event, state, member) => {
            const room = this.matrixClient.getRoom(state.roomId);
            if (!room) {
                return;
            }
            const memberList = state.getMembers();
            console.log(room.name);
            console.log(Array(room.name.length + 1).join("=")); // underline
            for (let i = 0; i < memberList.length; i++) {
                console.log("(%s) %s", memberList[i].membership, memberList[i].name);
            }
        });

        this.matrixClient.startClient().catch((err) => {
            console.error("Failed to start client:", err);
        });
    }
}
