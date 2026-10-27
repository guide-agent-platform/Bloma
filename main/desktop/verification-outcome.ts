/** Diagnostics for retained independent test-effectiveness checks. */
export interface VerificationRejection{decision:'reject';reason:'test-invalid'|'fault-survived';missingArtifacts:{gateId:string;artifacts:string[]}[];discardedObservations:never[];education:string}
