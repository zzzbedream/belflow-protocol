'use client';

import { createScope, type Scope } from 'animejs';
import { useEffect, useRef, type DependencyList, type RefObject } from 'react';

export interface KineticContext {
  root: HTMLElement | SVGElement;
  /** prefers-reduced-motion: jump to the end state instead of moving. */
  isReduced: boolean;
  /** Duration helper: 0 when motion is reduced. */
  ms: (duration: number) => number;
}

type Setup = (context: KineticContext, scope: Scope) => void | (() => void);

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Runs anime.js animations inside a scope bound to `ref`. Everything created
 * in `setup` is reverted when deps change or the component unmounts, so no
 * timeline outlives its DOM. Respects prefers-reduced-motion.
 */
export function useAnimeScope<T extends HTMLElement | SVGElement>(setup: Setup, deps: DependencyList): RefObject<T | null> {
  const ref = useRef<T>(null);
  const setupRef = useRef(setup);
  setupRef.current = setup;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const isReduced = prefersReducedMotion();
    const context: KineticContext = { root, isReduced, ms: (duration) => (isReduced ? 0 : duration) };
    const scope = createScope({ root }).add((self) => setupRef.current(context, self as Scope));
    return () => scope.revert();
    // The caller's deps decide when the animation restarts; setup is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

/**
 * True when the user asked for reduced motion, or the page is driven by
 * automation (navigator.webdriver): end states render instantly, no loops.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(REDUCED_QUERY).matches || navigator.webdriver === true;
}
