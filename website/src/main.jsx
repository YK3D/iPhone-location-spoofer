import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles/global.css";
import "./styles/sections.css";
import "./styles/sim.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
