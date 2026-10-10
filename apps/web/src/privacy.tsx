import { createContext, useContext, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

/** Presentation-only masking. Real values remain in state for gateway requests. */
export const PrivacyContext = createContext(false);
export function usePrivacy() {
  const hidden = useContext(PrivacyContext);
  return { hidden, mask: (value: unknown): string => hidden ? '***' : String(value ?? '') };
}

/** Omit private content from rendered text, links, tooltips and accessibility labels. */
export function Sensitive({ children }: { children: ReactNode }) {
  const { hidden } = usePrivacy();
  return hidden ? <span aria-label="Hidden for streaming">***</span> : <>{children}</>;
}

// Disable editing while masked so the placeholder cannot overwrite a real value.
export function PrivateInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { hidden } = usePrivacy();
  return <input {...props} {...(hidden ? { type: 'text', value: '***', placeholder: '***', title: undefined, disabled: true } : {})} />;
}
export function PrivateTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { hidden } = usePrivacy();
  return <textarea {...props} {...(hidden ? { value: '***', placeholder: '***', title: undefined, disabled: true } : {})} />;
}
