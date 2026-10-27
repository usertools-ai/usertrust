// Every order of the events around an awaiting hold, for a fork subagent, with a sibling's marker (see SiblingAt): see helpers/awaiting-orders.ts.
import { defineAwaitingOrders } from "./helpers/awaiting-orders.js";

defineAwaitingOrders("fork", 3);
