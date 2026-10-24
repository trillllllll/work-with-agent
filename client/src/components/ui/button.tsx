import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "surface-action outline-none disabled:pointer-events-none disabled:opacity-[var(--surface-button-disabled-opacity)] aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Content controls keep their owner's geometry; interaction states live here.
        plain: "surface-action-plain",
        row: "surface-action-row",
        tab: "surface-action-tab",
        chip: "surface-action-chip",
        card: "glass-surface surface-action-card",
        input: "glass-control",
        default: "glass-button glass-button-primary text-primary-foreground hover:text-primary-foreground",
        destructive:
          "glass-button glass-button-destructive text-destructive-foreground",
        outline:
          "glass-button glass-button-outline hover:text-accent-foreground",
        secondary:
          "glass-button glass-button-secondary text-secondary-foreground",
        ghost:
          "glass-button glass-button-ghost hover:text-accent-foreground",
        link: "text-brand-link underline-offset-4 hover:underline rounded-md focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
      },
      size: {
        bare: "",
        default: "h-9 gap-2 px-4 py-2 text-sm has-[>svg]:px-3 [&_svg:not([class*='size-'])]:size-4",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 text-sm has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-4",
        lg: "h-10 gap-2 rounded-md px-6 text-sm has-[>svg]:px-4 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-9 [&_svg:not([class*='size-'])]:size-4",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-10 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    compoundVariants: [{
      size: ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"],
      className: "inline-flex shrink-0 items-center justify-center whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:shrink-0",
    }],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
