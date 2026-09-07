import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsCenter,
  parseAuthorizedDevices,
} from '../../scripts/collect-android-physical-evidence.mjs';

test('ADB device parsing keeps only authorized device transports', () => {
  const devices = parseAuthorizedDevices(`List of devices attached\nABC123 device product:foo model:Phone transport_id:1\nOFFLINE offline transport_id:2\nDENIED unauthorized transport_id:3\n`);
  assert.deepEqual(devices, [{ serial: 'ABC123', state: 'device' }]);
});

test('UIAutomator Scan QR bounds are converted to a deterministic tap center', () => {
  const xml = '<hierarchy><node index="0" text="Scan QR" resource-id="" class="android.widget.Button" bounds="[100,300][300,380]" /></hierarchy>';
  assert.deepEqual(boundsCenter(xml, 'Scan QR'), { x: 200, y: 340 });
  assert.equal(boundsCenter(xml, 'Missing'), null);
});
