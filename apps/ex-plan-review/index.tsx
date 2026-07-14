import React from "react";
import ReactDOM from "react-dom/client";
import { PlanReviewApp } from "./PlanReviewApp";
import "./index.css";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Could not find Ex-Plannotator Plan root element.");
ReactDOM.createRoot(rootElement).render(<React.StrictMode><PlanReviewApp /></React.StrictMode>);
