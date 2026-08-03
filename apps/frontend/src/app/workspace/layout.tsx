import type { ReactNode } from "react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";

/**
 * Persistent workspace shell — stays mounted across /workspace/* navigations.
 */
export default function WorkspaceLayout({ children }: { readonly children: ReactNode }) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
