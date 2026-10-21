"use client";

import { createContext, useContext } from "react";
import type { CoinMeta } from "@/lib/symbols";

/** The coins shown on the site (set in the admin, read on the server), for client components under a coin page. */
export const CoinsContext = createContext<CoinMeta[]>([]);

export const useCoins = () => useContext(CoinsContext);
