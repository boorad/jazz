import { newRandomSessionID } from "./coValue.js";
import { LocalNode } from "./node.js";
import { connectedPeers } from "./streamUtils.js";

test("Can create a node while creating a new account with profile", async () => {
    const { node, accountID, accountSecret, sessionID } =
        LocalNode.withNewlyCreatedAccount("Hermes Puggington");

    expect(node).not.toBeNull();
    expect(accountID).not.toBeNull();
    expect(accountSecret).not.toBeNull();
    expect(sessionID).not.toBeNull();

    expect(node.expectProfileLoaded(accountID).get("name")).toEqual(
        "Hermes Puggington"
    );
    expect((await node.loadProfile(accountID)).get("name")).toEqual(
        "Hermes Puggington"
    );
});

test("A node with an account can create teams and and objects within them", async () => {
    const { node, accountID } =
        LocalNode.withNewlyCreatedAccount("Hermes Puggington");

    const team = await node.createTeam();
    expect(team).not.toBeNull();

    let map = team.createMap();
    map = map.edit((edit) => {
        edit.set("foo", "bar", "private");
        expect(edit.get("foo")).toEqual("bar");
    });

    expect(map.get("foo")).toEqual("bar");

    expect(map.getLastEditor("foo")).toEqual(accountID);
});

test("Can create account with one node, and then load it on another", async () => {
    const { node, accountID, accountSecret } =
        LocalNode.withNewlyCreatedAccount("Hermes Puggington");

    const team = await node.createTeam();
    expect(team).not.toBeNull();

    let map = team.createMap();
    map = map.edit((edit) => {
        edit.set("foo", "bar", "private");
        expect(edit.get("foo")).toEqual("bar");
    });

    const [node1asPeer, node2asPeer] = connectedPeers("node1", "node2", {trace: true, peer1role: "server", peer2role: "client"});

    node.sync.addPeer(node2asPeer);

    const node2 = await LocalNode.withLoadedAccount(
        accountID,
        accountSecret,
        newRandomSessionID(accountID),
        [node1asPeer]
    );

    const map2 = await node2.load(map.id);

    expect(map2.get("foo")).toEqual("bar");
});