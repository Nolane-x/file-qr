export class SessionState {
  constructor(createdAt, ttlMs, senderToken) {
    this.createdAt = createdAt;
    this.expiresAt = createdAt + ttlMs;
    this.senderToken = senderToken;
    this.senderJoined = false;
    this.receiverJoined = false;
    this.consumed = false;
  }

  isExpired(now = Date.now()) { return now >= this.expiresAt; }

  admit(role, token = '', now = Date.now()) {
    if (this.isExpired(now)) throw new Error('Session expired');
    if (this.consumed) throw new Error('Session consumed');
    if (role === 'sender') {
      if (token !== this.senderToken) throw new Error('Invalid sender token');
      if (this.senderJoined) throw new Error('Sender already connected');
      this.senderJoined = true;
      return { role };
    }
    if (role === 'receiver') {
      if (this.receiverJoined) throw new Error('Receiver already connected');
      this.receiverJoined = true;
      return { role };
    }
    throw new Error('Invalid role');
  }

  consume() { this.consumed = true; }
}
