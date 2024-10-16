import { reactive, ref } from "vue";
import { BrowserDemoAuth } from "jazz-browser";
import { Account, ID } from "jazz-tools";
import { AgentSecret } from "cojson";

export type DemoAuthState = (
    | {
          state: "uninitialized";
      }
    | {
          state: "loading";
      }
    | {
          state: "ready";
          existingUsers: string[];
          signUp: (username: string) => void;
          logInAs: (existingUser: string) => void;
      }
    | {
          state: "signedIn";
          logOut: () => void;
      }
) & {
    errors: string[];
};

/** @category Auth Providers */
export function useDemoAuth({
    seedAccounts,
}: {
    seedAccounts?: {
        [name: string]: { accountID: ID<Account>; accountSecret: AgentSecret };
    };
} = {}) {
    const state = reactive<DemoAuthState>({
        state: "loading",
        errors: [],
    });

    const authMethod = ref(
        new BrowserDemoAuth(
            {
                onReady: ({ signUp, existingUsers, logInAs }) => {
                    state.state = "ready";
                    (state as DemoAuthState & { state: "ready" }).signUp =
                        signUp;
                    (
                        state as DemoAuthState & { state: "ready" }
                    ).existingUsers = existingUsers;
                    (state as DemoAuthState & { state: "ready" }).logInAs =
                        logInAs;
                    state.errors = [];
                    console.log("ready");
                },
                onSignedIn: ({ logOut }) => {
                    state.state = "signedIn";
                    (state as DemoAuthState & { state: "signedIn" }).logOut =
                        logOut;
                    state.errors = [];
                },
                onError: (error) => {
                    state.errors.push(error.toString());
                },
            },
            seedAccounts,
        ),
    );

    return [authMethod, state] as const;
}
