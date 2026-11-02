// Every order of the events around an awaiting hold, for a fork subagent, each call in its own response: see helpers/awaiting-orders.ts.
import { defineAwaitingOrders } from "./helpers/awaiting-orders.js";

defineAwaitingOrders("fork", "none", "separate");
