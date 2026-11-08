export interface Bindings {
  RELAY: DurableObjectNamespace;
  ENVIRONMENT: string;
  /** Deus Cloud's public relay ticket keys, `{"keys":[...]}`. Unset rejects every socket. */
  RELAY_TICKET_JWKS?: string;
}
