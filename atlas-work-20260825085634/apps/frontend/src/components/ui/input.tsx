import * as React from "react";
import { cn } from "@atlas/ui";

/**
 * Renders a styled form input with stable sizing.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  return (
    <input
      ref={ref}
      {...props}
      className={cn(
        "h-10 w-full rounded-md border bg-white px-3 text-sm outline-none transition focus:ring-2 focus:ring-ring",
        props.className
      )}
    />
  );
});
