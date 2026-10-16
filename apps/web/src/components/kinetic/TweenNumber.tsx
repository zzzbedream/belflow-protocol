'use client';

import { animate } from 'animejs';
import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from './useAnimeScope';

interface TweenNumberProps {
  /** Final value as a decimal string (exact; the tween is only cosmetic). */
  value: string;
  className?: string;
  durationMs?: number;
}

/**
 * Counts up to `value` with anime.js. The settled text is always the exact
 * string passed in, so tests and screen readers read the real figure.
 */
export function TweenNumber({ value, className, durationMs = 1400 }: TweenNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const target = Number(value.replace(/,/g, ''));
    if (!Number.isFinite(target) || target === 0 || prefersReducedMotion()) {
      element.textContent = value;
      return;
    }
    const decimals = value.split('.')[1]?.length ?? 0;
    const counter = { n: 0 };
    const animation = animate(counter, {
      n: target,
      duration: durationMs,
      ease: 'outExpo',
      onUpdate: () => {
        element.textContent = counter.n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      },
      onComplete: () => {
        element.textContent = value;
      },
    });
    return () => {
      animation.revert();
      element.textContent = value;
    };
  }, [value, durationMs]);

  // key={value}: the effect writes textContent directly, so a new value gets a fresh node.
  return (
    <span key={value} ref={ref} className={className}>
      {value}
    </span>
  );
}
