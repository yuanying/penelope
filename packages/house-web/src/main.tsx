import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App.tsx";

const fetchFromWindow = window.fetch.bind(window);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App fetch={fetchFromWindow} open={(url) => new EventSource(url)} />
  </StrictMode>,
);
