import { describe, it, expect } from 'vitest';
import type { Instance } from '@aws-sdk/client-ec2';
import { toInstance } from './aws.js';

const raw: Instance = {
  InstanceId: 'i-0abc',
  State: { Name: 'running' },
  InstanceType: 't3.micro',
  PublicIpAddress: '3.3.3.3',
  PrivateIpAddress: '172.31.0.5',
  Placement: { AvailabilityZone: 'us-east-1a' },
  Tags: [
    { Key: 'Name', Value: 'api-1' },
    { Key: 'Env', Value: 'prod' },
  ],
};

describe('aws toInstance', () => {
  it('maps an instance, using the Name tag and not duplicating it', () => {
    expect(toInstance(raw, 'us-east-1')).toEqual({
      id: 'i-0abc',
      name: 'api-1',
      region: 'us-east-1',
      state: 'running',
      publicIp: '3.3.3.3',
      privateIp: '172.31.0.5',
      tags: ['Env:prod'],
      instanceType: 't3.micro',
    });
  });

  it('falls back to the instance id as name', () => {
    expect(toInstance({ ...raw, Tags: [] }, 'us-east-1').name).toBe('i-0abc');
    expect(toInstance({ ...raw, Tags: [{ Key: 'Name', Value: '  ' }] }, 'us-east-1').name).toBe('i-0abc');
  });

  it('maps stopping → stopped and terminated → other', () => {
    expect(toInstance({ ...raw, State: { Name: 'stopping' } }, 'us-east-1').state).toBe('stopped');
    expect(toInstance({ ...raw, State: { Name: 'terminated' } }, 'us-east-1').state).toBe('other');
  });

  it('leaves a stopped instance without a public address at null', () => {
    const { PublicIpAddress: _drop, ...stopped } = raw;
    expect(toInstance({ ...stopped, State: { Name: 'stopped' } }, 'us-east-1').publicIp).toBeNull();
  });
});
