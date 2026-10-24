import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "surface-switch peer inline-flex h-6 w-10 shrink-0 items-center rounded-full border p-px outline-none disabled:cursor-not-allowed motion-reduce:transition-none",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="surface-switch-thumb pointer-events-none block size-5 rounded-full ring-0 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
