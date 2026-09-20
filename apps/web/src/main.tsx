import React from "react";
import ReactDOM from "react-dom/client";
import { Amplify } from "aws-amplify";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import { App } from "./App.js";
import "./styles.css";

Amplify.configure({ Auth: { Cognito: {
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
  signUpVerificationMethod: "code",
} } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Authenticator hideSignUp>{({ signOut, user }) => <App email={user?.signInDetails?.loginId ?? "operator"} signOut={signOut} />}</Authenticator>
  </React.StrictMode>,
);
