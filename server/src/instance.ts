import { randomUUID } from "node:crypto";

/** A random identifier minted once per control-plane process. It is exposed by the
 *  unauthenticated `/api/health` endpoint (it reveals nothing about the deployment)
 *  so NginUX can recognise ITSELF: before a non-admin publishes a service, the host
 *  write path probes the proposed upstream and refuses it when the thing answering
 *  is this very control plane reached through a LAN address or a remapped Docker
 *  port - a path the static loopback checks in hostschema.ts cannot see. */
export const INSTANCE_ID = randomUUID();
