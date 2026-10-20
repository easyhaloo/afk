/**
 * What a credential secret may hold.
 *
 * A secret is written into the credential file as one line, so it may not
 * be empty and may not contain a newline or a NUL; and the file has a
 * size, so it may not be unbounded.  The SSH credential store and the
 * JumpServer credential store each had this rule, each with its own copy
 * of the check and its own maximum.
 */
export const MAX_CREDENTIAL_SECRET_BYTES = 4096;

export function isValidCredentialSecret(value: string): boolean {
  return !!value
    && !value.includes("\0")
    && !value.includes("\r")
    && !value.includes("\n")
    && Buffer.byteLength(value, "utf8") <= MAX_CREDENTIAL_SECRET_BYTES;
}
