import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-[transform,background-color,color,box-shadow] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        primary:
          'bg-ink text-paper shadow-[inset_0_-2px_0_oklch(0%_0_0/0.25)] hover:bg-vault hover:shadow-[inset_0_-2px_0_oklch(0%_0_0/0.3),0_6px_18px_-8px_var(--vault)]',
        vault: 'bg-vault text-paper hover:brightness-110 shadow-[0_6px_18px_-10px_var(--vault)]',
        outline: 'border border-rule-strong bg-paper text-ink hover:border-ink hover:bg-paper-2',
        ghost: 'text-ink-2 hover:bg-paper-2 hover:text-ink',
        danger: 'bg-danger text-paper hover:brightness-110',
      },
      size: {
        sm: 'h-8 rounded-[6px] px-3 text-xs',
        md: 'h-10 rounded-[7px] px-4 text-sm',
        lg: 'h-12 rounded-[8px] px-6 text-[0.95rem] tracking-tight',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, ...props }, ref) {
  return <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
