import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type SshActionButtonVariant = "primary" | "secondary" | "danger";
export type SshActionButtonSize = "sm" | "md";

type SshActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  children: ReactNode;
  size?: SshActionButtonSize;
  variant?: SshActionButtonVariant;
};

export const SshActionButton = forwardRef<HTMLButtonElement, SshActionButtonProps>(function SshActionButton({ children, className, size = "md", variant = "secondary", ...props }, ref) {
  const classes = ["ssh-action-button", `ssh-action-button-${size}`, `ssh-action-button-${variant}`, className].filter(Boolean).join(" ");
  return <button {...props} ref={ref} className={classes}>{children}</button>;
});
