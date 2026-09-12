export async function prepareAndroidPhysicalEvidence() {
  throw new Error('FQR_ANDROID_PHYSICAL_AUTHORITY_NOT_IMPLEMENTED');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await prepareAndroidPhysicalEvidence();
}
