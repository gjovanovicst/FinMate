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
  /* The front door is a card on the page background, not a bare form, so the first screen a person sees
     is made of the same material as every screen behind it (ADR-039). The max-inline-size is a form
     measure — one field per line, never a two-column sign-in. */
  .auth {
    max-inline-size: 27rem;
    margin-inline: auto;
    padding: var(--space-6);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-1);
  }
  /* The brand sits above the title, centred with it: a sign-in page is the one place the product has to
     say what it is before it asks for anything. */
  .auth__brand {
    display: flex;
    justify-content: center;
    margin-block-end: var(--space-5);
  }
  .auth__title {
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
    margin-block: 0 var(--space-2);
    text-align: center;
  }
  .auth__hint {
    margin-block: 0 var(--space-5);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    text-align: center;
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
    min-block-size: var(--control-size-comfortable);
    font: inherit;
    color: var(--color-text);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }
  .field__input:hover {
    border-color: var(--color-border-strong);
  }
  .field__input:focus-visible {
    border-color: var(--color-primary);
  }
  .auth__error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
  /* The submit's progress state, in place of the form. Sign-in and sign-up navigate to a **lazy** route
     on success, and the router keeps the component mounted until that route is ready — so the form was
     the only thing on screen for the whole of the load with a disabled button as its only signal. */
  .auth__progress {
    margin: 0;
    padding-block: var(--space-6);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    text-align: center;
  }
  .auth__submit {
    padding: var(--space-3);
    font: inherit;
    font-weight: var(--weight-semibold);
    color: var(--color-primary-contrast);
    background: var(--color-primary);
    border: none;
    border-radius: var(--radius-sm);
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
    text-align: center;
  }
  /* Sign-in's way into the recovery flow: a grid item under the password field, right-aligned so it
     reads as an aside to the field above it rather than as another input. */
  .auth__forgot {
    margin: 0;
    justify-self: end;
    font-size: var(--text-sm);
  }
`;
