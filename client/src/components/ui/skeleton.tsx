import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("glass-subtle animate-pulse rounded-lg", className)}
      {...props}
    />
  )
}

export { Skeleton }
