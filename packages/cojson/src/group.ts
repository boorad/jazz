import { CoID, ContentType } from "./contentType.js";
import { CoMap } from "./contentTypes/coMap.js";
import { JsonObject, JsonValue } from "./jsonValue.js";
import {
    Encrypted,
    KeyID,
    KeySecret,
    createdNowUnique,
    newRandomKeySecret,
    seal,
    encryptKeySecret,
    getAgentSealerID,
    Sealed,
    newRandomSecretSeed,
    agentSecretFromSecretSeed,
    getAgentID,
} from "./crypto.js";
import { LocalNode } from "./node.js";
import { SessionID, isAgentID } from "./ids.js";
import {
    AccountIDOrAgentID,
    GeneralizedControlledAccount,
    Profile,
} from "./account.js";
import { Role } from "./permissions.js";
import { base58 } from "@scure/base";

export type GroupContent = {
    profile: CoID<Profile> | null;
    [key: AccountIDOrAgentID]: Role;
    readKey: KeyID;
    [revelationFor: `${KeyID}_for_${AccountIDOrAgentID}`]: Sealed<KeySecret>;
    [oldKeyForNewKey: `${KeyID}_for_${KeyID}`]: Encrypted<
        KeySecret,
        { encryptedID: KeyID; encryptingID: KeyID }
    >;
};

export function expectGroupContent(
    content: ContentType
): CoMap<GroupContent, JsonObject | null> {
    if (content.type !== "comap") {
        throw new Error("Expected map");
    }

    return content as CoMap<GroupContent, JsonObject | null>;
}

export class Group {
    groupMap: CoMap<GroupContent, JsonObject | null>;
    node: LocalNode;

    constructor(
        groupMap: CoMap<GroupContent, JsonObject | null>,
        node: LocalNode
    ) {
        this.groupMap = groupMap;
        this.node = node;
    }

    get id(): CoID<CoMap<GroupContent, JsonObject | null>> {
        return this.groupMap.id;
    }

    roleOf(accountID: AccountIDOrAgentID): Role | undefined {
        return this.groupMap.get(accountID);
    }

    myRole(): Role | undefined {
        return this.roleOf(this.node.account.id);
    }

    addMember(accountID: AccountIDOrAgentID, role: Role) {
        this.groupMap = this.groupMap.edit((map) => {
            const currentReadKey = this.groupMap.coValue.getCurrentReadKey();

            if (!currentReadKey.secret) {
                throw new Error("Can't add member without read key secret");
            }

            const agent = this.node.resolveAccountAgent(
                accountID,
                "Expected to know agent to add them to group"
            );

            map.set(accountID, role, "trusting");

            if (map.get(accountID) !== role) {
                throw new Error("Failed to set role");
            }

            map.set(
                `${currentReadKey.id}_for_${accountID}`,
                seal(
                    currentReadKey.secret,
                    this.groupMap.coValue.node.account.currentSealerSecret(),
                    getAgentSealerID(agent),
                    {
                        in: this.groupMap.coValue.id,
                        tx: this.groupMap.coValue.nextTransactionID(),
                    }
                ),
                "trusting"
            );
        });
    }

    createInvite(role: "reader" | "writer" | "admin"): InviteSecret {
        const secretSeed = newRandomSecretSeed();

        const inviteSecret = agentSecretFromSecretSeed(secretSeed);
        const inviteID = getAgentID(inviteSecret);

        this.addMember(inviteID, `${role}Invite` as Role);

        return inviteSecretFromSecretSeed(secretSeed);
    }

    rotateReadKey() {
        const currentlyPermittedReaders = this.groupMap.keys().filter((key) => {
            if (key.startsWith("co_") || isAgentID(key)) {
                const role = this.groupMap.get(key);
                return (
                    role === "admin" || role === "writer" || role === "reader"
                );
            } else {
                return false;
            }
        }) as AccountIDOrAgentID[];

        const maybeCurrentReadKey = this.groupMap.coValue.getCurrentReadKey();

        if (!maybeCurrentReadKey.secret) {
            throw new Error(
                "Can't rotate read key secret we don't have access to"
            );
        }

        const currentReadKey = {
            id: maybeCurrentReadKey.id,
            secret: maybeCurrentReadKey.secret,
        };

        const newReadKey = newRandomKeySecret();

        this.groupMap = this.groupMap.edit((map) => {
            for (const readerID of currentlyPermittedReaders) {
                const reader = this.node.resolveAccountAgent(
                    readerID,
                    "Expected to know currently permitted reader"
                );

                map.set(
                    `${newReadKey.id}_for_${readerID}`,
                    seal(
                        newReadKey.secret,
                        this.groupMap.coValue.node.account.currentSealerSecret(),
                        getAgentSealerID(reader),
                        {
                            in: this.groupMap.coValue.id,
                            tx: this.groupMap.coValue.nextTransactionID(),
                        }
                    ),
                    "trusting"
                );
            }

            map.set(
                `${currentReadKey.id}_for_${newReadKey.id}`,
                encryptKeySecret({
                    encrypting: newReadKey,
                    toEncrypt: currentReadKey,
                }).encrypted,
                "trusting"
            );

            map.set("readKey", newReadKey.id, "trusting");
        });
    }

    removeMember(accountID: AccountIDOrAgentID) {
        this.groupMap = this.groupMap.edit((map) => {
            map.set(accountID, "revoked", "trusting");
        });

        this.rotateReadKey();
    }

    createMap<
        M extends { [key: string]: JsonValue },
        Meta extends JsonObject | null = null
    >(meta?: Meta): CoMap<M, Meta> {
        return this.node
            .createCoValue({
                type: "comap",
                ruleset: {
                    type: "ownedByGroup",
                    group: this.groupMap.id,
                },
                meta: meta || null,
                ...createdNowUnique(),
            })
            .getCurrentContent() as CoMap<M, Meta>;
    }

    testWithDifferentAccount(
        account: GeneralizedControlledAccount,
        sessionId: SessionID
    ): Group {
        return new Group(
            expectGroupContent(
                this.groupMap.coValue
                    .testWithDifferentAccount(account, sessionId)
                    .getCurrentContent()
            ),
            this.node
        );
    }
}

export type InviteSecret = `inviteSecret_z${string}`;

function inviteSecretFromSecretSeed(secretSeed: Uint8Array): InviteSecret {
    return `inviteSecret_z${base58.encode(secretSeed)}`;
}

export function secretSeedFromInviteSecret(inviteSecret: InviteSecret) {
    if (!inviteSecret.startsWith("inviteSecret_z")) {
        throw new Error("Invalid invite secret");
    }

    return base58.decode(inviteSecret.slice("inviteSecret_z".length));
}