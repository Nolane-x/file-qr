export class SessionState {
  constructor(createdAt, ttlMs, senderToken) {
    this.createdAt = createdAt;
    this.expiresAt = createdAt + ttlMs;
    this.senderToken = senderToken;
    this.senderJoined = false;
    this.attemptCounter = 0;
    this.receiverAttemptId = null;
  }

  isExpired(now = Date.now()) { return now >= this.expiresAt; }

  get receiverActive() { return this.receiverAttemptId !== null; }

  admit(role, token = '', now = Date.now()) {
    if (this.isExpired(now)) throw new Error('Session expired');
    if (role === 'sender') {
      if (token !== this.senderToken) throw new Error('Invalid sender token');
      if (this.senderJoined) throw new Error('Sender already connected');
      this.senderJoined = true;
      return { role };
    }
    if (role === 'receiver') {
      if (this.receiverActive) throw new Error('Receiver already connected');
      this.attemptCounter += 1;
      this.receiverAttemptId = this.attemptCounter;
      return { role, attemptId: this.receiverAttemptId };
    }
    throw new Error('Invalid role');
  }

  releaseReceiver(attemptId) {
    if (!Number.isInteger(attemptId) || this.receiverAttemptId !== attemptId) return false;
    this.receiverAttemptId = null;
    return true;
  }
}
