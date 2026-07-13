import React from "react";
import ReactDOM from "react-dom/client";
import { PlanReviewPrototype } from "./PlanReviewPrototype";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Could not find prototype root element.");

ReactDOM.createRoot(rootElement).render(
	<React.StrictMode>
		<PlanReviewPrototype />
	</React.StrictMode>,
);
