/**
 * The auth screens' shared styles (F-28).
 *
 * Sign-in, sign-up, password reset and email confirmation are one form in four states, and each
 * component used to carry its own copy of this block — with the drift that always follows: sign-in had
 * a focus ring and a colour transition, sign-up did not. One exported constant instead.
 *
 * ⚠️ It is a **constant**, not a `.css` file, because `styles: [...]` is evaluated statically by the AOT
 * compiler: a value it cannot resolve is a build failure, and one that names nothing ("Failed to resolve
 * styles at position 1 to a string"). A plain exported string is a value it *can* resolve — verified by
 * the build, not assumed (docs/15).
 *
 * @module apps/web/src/app/features/auth
 */
export const AUTH_STYLES = `
  .auth {
    max-inline-size: 380px;
    margin-inline: auto;
    padding-block-start: var(--space-6);
  }
  .auth__title {
    font-size: var(--text-2xl);
    margin-block: 0 var(--space-2);
  }
  .auth__hint {
    margin-block: 0 var(--space-5);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
  .auth__form {
    display: grid;
    gap: var(--space-4);
  }
  .field {
    display: grid;
    gap: var(--space-1);
  }
  .field__label {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
  .field__hint {
    font-size: var(--text-xs);
    color: var(--color-text-subtle);
  }
  .field__input {
    padding: var(--space-3);
    font: inherit;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .field__input:focus-visible {
    border-color: var(--color-primary);
  }
  .auth__error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
  .auth__submit {
    padding: var(--space-3);
    font: inherit;
    font-weight: 600;
    color: var(--color-primary-contrast);
    background: var(--color-primary);
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background var(--motion-fast) ease;
  }
  .auth__submit:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
  .auth__submit:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .auth__alt {
    margin-block-start: var(--space-5);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
  /* Sign-in's way into the recovery flow: a grid item under the password field, right-aligned so it
     reads as an aside to the field above it rather than as another input. */
  .auth__forgot {
    margin: 0;
    justify-self: end;
    font-size: var(--text-sm);
  }
`;
