import React from "react";
import ReactDOM from "react-dom/client";
import { Amplify } from "aws-amplify";
import { Authenticator } from "@aws-amplify/ui-react";
import { I18n } from "aws-amplify/utils";
import "@aws-amplify/ui-react/styles.css";
import { App } from "./App.js";
import "./styles.css";

Amplify.configure({ Auth: { Cognito: {
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
  signUpVerificationMethod: "code",
} } });

I18n.putVocabularies({ "zh-TW": {
  "Sign In": "登入",
  "Sign in": "登入",
  "Email": "電子郵件",
  "Password": "密碼",
  "Forgot your password?": "忘記密碼？",
  "Reset Password": "重設密碼",
  "Send code": "寄送驗證碼",
  "Back to Sign In": "返回登入",
  "Confirm Password": "確認密碼",
  "New Password": "新密碼",
  "Submit": "送出",
  "Change Password": "更換密碼",
  "Incorrect username or password.": "電子郵件或密碼不正確。",
} });
I18n.setLanguage("zh-TW");

const authComponents = {
  Header() {
    return <div className="auth-brand"><span className="brand-mark">S</span><div><strong>SIGNIFY</strong><small>Cloud session control</small></div></div>;
  },
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Authenticator
      hideSignUp
      loginMechanisms={["email"]}
      components={authComponents}
      formFields={{ signIn: {
        username: { label: "電子郵件", placeholder: "name@example.com", isRequired: true },
        password: { label: "密碼", placeholder: "輸入密碼", isRequired: true },
      } }}
    >{({ signOut, user }) => <App email={user?.signInDetails?.loginId ?? "operator"} signOut={signOut} />}</Authenticator>
  </React.StrictMode>,
);
