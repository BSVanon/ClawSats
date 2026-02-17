import { SharingProtocol } from '../../src/protocol';
import { WalletConfig } from '../../src/types';

const baseConfig: WalletConfig = {
  identityKey: '03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  chain: 'main',
  storageType: 'memory',
  endpoints: {
    jsonrpc: 'http://127.0.0.1:3321',
    health: 'http://127.0.0.1:3321/health',
    discovery: 'http://127.0.0.1:3321/discovery'
  },
  capabilities: ['createAction', 'internalizeAction'],
  clawsats: {
    feeKeyId: 'clawsats-fee-v1',
    defaultFeeSuffix: 'fee'
  }
};

describe('SharingProtocol recipient-bound signatures', () => {
  test('createInvitation signs using recipient identity key as counterparty', async () => {
    const createSignature = jest.fn().mockResolvedValue({ signature: [1, 2, 3, 4] });
    const wallet = { createSignature };
    const sharing = new SharingProtocol(baseConfig, wallet);

    const recipientIdentityKey = '03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const invitation = await sharing.createInvitation('claw://recipient', {
      recipientEndpoint: 'http://peer.example:3321',
      recipientIdentityKey
    });

    expect(invitation.signature).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
    expect(invitation.recipient.publicKey).toBe(recipientIdentityKey);
    expect(createSignature).toHaveBeenCalledTimes(1);
    expect(createSignature.mock.calls[0][0]).toMatchObject({
      protocolID: [0, 'clawsats sharing'],
      keyID: 'sharing-v1',
      counterparty: recipientIdentityKey
    });
  });

  test('createAnnouncement signs using recipient identity key when provided', async () => {
    const createSignature = jest.fn().mockResolvedValue({ signature: [9, 9, 9] });
    const wallet = { createSignature };
    const sharing = new SharingProtocol(baseConfig, wallet);

    const recipientIdentityKey = '03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    await sharing.createAnnouncement({ recipientIdentityKey });

    expect(createSignature).toHaveBeenCalledTimes(1);
    expect(createSignature.mock.calls[0][0]).toMatchObject({
      protocolID: [0, 'clawsats sharing'],
      keyID: 'sharing-v1',
      counterparty: recipientIdentityKey
    });
  });

  test('signPayload throws when wallet is unavailable', async () => {
    const sharing = new SharingProtocol(baseConfig);
    await expect(sharing.signPayload('abc')).rejects.toThrow('Wallet unavailable for signing');
  });
});
