import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "glass-control flex field-sizing-content min-h-16 w-full px-3 py-2 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed aria-invalid:border-destructive md:text-sm dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
