# Architecture

The operator Web app authenticates with Amazon Cognito and calls JWT-protected HTTP API routes. Devices redeem a single-use pairing code for an opaque credential, use it for the latest-config REST request, and present it in the WebSocket upgrade Authorization header.

The WebSocket connection registry stores both the API Gateway connection ID and the Unity-generated protocol connection ID. A connection becomes command-ready only after `client_hello`, `server_hello`, and an authoritative full snapshot.

Commands are durable intent records. An atomic sequence allocator and command ledger precede delivery. Device ACK/NACK records ingress only; `command_result` or `judgment_result` records terminal truth. A server desired target never overwrites a device snapshot.

AWS resources are separate per environment. Recording Tools functions, APIs, tables, buckets, layers, and IAM roles are not reused.
