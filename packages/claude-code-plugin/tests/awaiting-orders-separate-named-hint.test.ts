// Every order of the events around an awaiting hold, for a named-hint subagent, each call in its own response: see helpers/awaiting-orders.ts.
import { defineAwaitingOrders } from "./helpers/awaiting-orders.js";

defineAwaitingOrders("named-hint", "none", "separate");
