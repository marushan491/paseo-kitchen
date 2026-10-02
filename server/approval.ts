import { createHash, timingSafeEqual } from "node:crypto";

export interface ApprovalProof {
  method: "plugin-credential";
  credentialId: string;
  candidateCommit: string;
  at: string;
}

export function verifyOperatorApproval(input: {
  configuredCredential: string | undefined;
  suppliedCredential: string | undefined;
  candidateCommit: string;
  requestedCommit: string | undefined;
  now?: Date;
}): ApprovalProof {
  const configured = input.configuredCredential;
  if (!configured || configured.length < 32)
    throw new Error(
      "Provision a server-only operator credential of at least 32 characters before approval",
    );
  if (
    !/^[a-f0-9]{40,64}$/.test(input.candidateCommit) ||
    input.requestedCommit !== input.candidateCommit
  )
    throw new Error("Approval must name the current verified candidate commit");
  const supplied = input.suppliedCredential;
  if (!supplied || supplied.length > 4096 || !timingSafeEqual(hash(configured), hash(supplied)))
    throw new Error("Operator approval credential rejected");
  return {
    method: "plugin-credential",
    credentialId: hash(configured).toString("hex").slice(0, 16),
    candidateCommit: input.candidateCommit,
    at: (input.now ?? new Date()).toISOString(),
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest();
}
