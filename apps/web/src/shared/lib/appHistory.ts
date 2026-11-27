import { createBrowserHistory } from "@tanstack/react-router";

let history: ReturnType<typeof createBrowserHistory> | undefined;
export const appHistory = () => (history ??= createBrowserHistory());
