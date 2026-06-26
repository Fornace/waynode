import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// Remove the branded boot screen once React has rendered into #root. This used
// to be an inline <script> in index.html; it moved here so the server can ship
// a strict CSP (`script-src 'self'`) without an inline-script exception.
const removeBoot = () => {
  const boot = document.getElementById("boot");
  if (!boot) return;
  if (document.getElementById("root")?.hasChildNodes()) boot.remove();
  else requestAnimationFrame(removeBoot);
};
requestAnimationFrame(removeBoot);
