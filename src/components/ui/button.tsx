import { forwardRef, ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const baseStyles = 'inline-flex items-center justify-center font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-macaron-mint/60 rounded-2xl border border-transparent shadow-sm shadow-macaron-mint/40';
const variantStyles: Record<string, string> = {
  primary: 'bg-macaron-peach text-rose-950 hover:bg-macaron-apricot focus-visible:ring-macaron-peach/80',
  secondary: 'bg-macaron-mint text-emerald-900 hover:bg-macaron-mint/90 focus-visible:ring-macaron-mint/80',
  ghost: 'bg-transparent border border-white/20 text-white hover:bg-white/5 focus-visible:ring-white/50',
  danger: 'bg-rose-500 text-white hover:bg-rose-600 focus-visible:ring-rose-400',
};
const sizeStyles: Record<string, string> = {
  default: 'px-4 py-2 text-sm',
  sm: 'px-3 py-1.5 text-xs',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variantStyles;
  size?: keyof typeof sizeStyles;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(baseStyles, variantStyles[variant], sizeStyles[size], className)}
      {...props}
    />
  )
);
Button.displayName = 'Button';
