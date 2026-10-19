"use client";

import { Explain } from "./Explain";

/** A glossary word that explains itself on click. */
export function Term({ k, children }: { k: string; children?: React.ReactNode }) {
  return (
    <Explain k={k} variant="term">
      {children}
    </Explain>
  );
}
