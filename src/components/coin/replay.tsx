"use client";

import { createContext, useContext } from "react";
import type { Candle } from "@/lib/types";

/**
 * Time-machine state shared by the coin page, every chart and the
 * multi-timeframe strips: whether a bar is being picked, and when replaying,
 * the bars that came after the chosen moment.
 */
export interface ReplayState {
  picking: boolean;
  pick: (t: number) => void;
  asOf: number | null;
  future: Candle[] | null;
}

export const ReplayContext = createContext<ReplayState | null>(null);
export const useReplay = () => useContext(ReplayContext);
