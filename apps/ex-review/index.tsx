import React from "react";
import ReactDOM from "react-dom/client";
import { LiveMessageReviewApp } from "./LiveMessageReviewApp";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Could not find Ex-Plannotator root element.");

ReactDOM.createRoot(rootElement).render(
	<React.StrictMode>
		<LiveMessageReviewApp />
	</React.StrictMode>,
);
