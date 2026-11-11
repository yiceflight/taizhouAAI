import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installFrontendDiagnostics, recordFrontendError } from "./lib/diagnostics";

installFrontendDiagnostics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onUncaughtError: (error, info) => recordFrontendError('react.uncaught', error, { componentStack: info.componentStack }),
  onCaughtError: (error, info) => recordFrontendError('react.caught', error, { componentStack: info.componentStack }),
  onRecoverableError: (error, info) => recordFrontendError('react.recoverable', error, { componentStack: info.componentStack }),
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
