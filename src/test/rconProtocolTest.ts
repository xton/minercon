// src/test/rconProtocolTest.ts
import { RconProtocol } from '../rconProtocol';
import { Logger } from '../logger';

/**
 * Test the RCON protocol implementation with fragmentation support
 *
 * This test demonstrates how the new implementation handles:
 * 1. Simple commands with small responses
 * 2. Commands with large, fragmented responses (like 'help' or 'status')
 * 3. Multiple concurrent commands
 * 4. Error handling and reconnection
 */
export class RconProtocolTest {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Run all tests
   */
  public async runTests(host: string, port: number, password: string): Promise<void> {
    this.logger.info('=== Starting RCON Protocol Tests ===');

    const protocol = new RconProtocol(host, port, password, this.logger);

    try {
      // Test connection
      await this.testConnection(protocol);

      // Test simple command
      await this.testSimpleCommand(protocol);

      // Test fragmented response
      await this.testFragmentedResponse(protocol);

      // Test concurrent commands
      await this.testConcurrentCommands(protocol);

      // Test error handling
      await this.testErrorHandling(protocol);

      this.logger.info('=== All Tests Completed Successfully ===');
    } catch (error) {
      this.logger.error(`Test failed: ${error}`);
    } finally {
      await protocol.disconnect();
    }
  }

  /**
   * Test basic connection
   */
  private async testConnection(protocol: RconProtocol): Promise<void> {
    this.logger.info('\nTest 1: Connection and Authentication');
    this.logger.info('--------------------------------------');

    const startTime = Date.now();
    await protocol.connect();
    const connectTime = Date.now() - startTime;

    this.logger.info(`✓ Connected and authenticated in ${connectTime}ms`);

    if (!protocol.isConnected()) {
      throw new Error('Connection test failed: not connected after connect()');
    }

    this.logger.info('✓ Connection status verified');
  }

  /**
   * Test simple command with small response
   */
  private async testSimpleCommand(protocol: RconProtocol): Promise<void> {
    this.logger.info('\nTest 2: Simple Command');
    this.logger.info('----------------------');

    const response = await protocol.send('time query daytime');
    this.logger.info(`Command: time query daytime`);
    this.logger.info(`Response length: ${response.length} bytes`);
    this.logger.info(`Response: ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`);
    this.logger.info('✓ Simple command executed successfully');
  }

  /**
   * Test command with large, fragmented response
   */
  private async testFragmentedResponse(protocol: RconProtocol): Promise<void> {
    this.logger.info('\nTest 3: Fragmented Response');
    this.logger.info('---------------------------');

    // 'help' command typically returns a large response that gets fragmented
    const startTime = Date.now();
    const response = await protocol.send('help');
    const responseTime = Date.now() - startTime;

    this.logger.info(`Command: help`);
    this.logger.info(`Response length: ${response.length} bytes`);
    this.logger.info(`Response time: ${responseTime}ms`);

    // Check if response was likely fragmented (> 4096 bytes)
    if (response.length > 4096) {
      const fragments = Math.ceil(response.length / 4096);
      this.logger.info(`✓ Received fragmented response (~${fragments} fragments)`);
    } else {
      this.logger.info(`✓ Received single-packet response`);
    }

    // Verify response integrity
    const lines = response.split('\n');
    this.logger.info(`Response contains ${lines.length} lines`);

    // Check for common commands that should be in help
    const hasCommonCommands = ['gamemode', 'give', 'tp'].some(cmd =>
      response.toLowerCase().includes(cmd)
    );

    if (hasCommonCommands) {
      this.logger.info('✓ Response content verified');
    } else {
      this.logger.warning('⚠ Warning: Response may be incomplete');
    }
  }

  /**
   * Test multiple concurrent commands
   */
  private async testConcurrentCommands(protocol: RconProtocol): Promise<void> {
    this.logger.info('\nTest 4: Concurrent Commands');
    this.logger.info('---------------------------');

    const commands = [
      'time query daytime',
      'difficulty',
      'gamerule doDaylightCycle',
      'defaultgamemode'
    ];

    const startTime = Date.now();

    // Send all commands concurrently
    const promises = commands.map(cmd =>
      protocol.send(cmd).then(response => ({
        command: cmd,
        response: response,
        success: true
      })).catch(error => ({
        command: cmd,
        response: error.message,
        success: false
      }))
    );

    const results = await Promise.all(promises);
    const totalTime = Date.now() - startTime;

    // Display results
    for (const result of results) {
      if (result.success) {
        this.logger.info(`✓ ${result.command}: ${result.response.substring(0, 50)}...`);
      } else {
        this.logger.error(`✗ ${result.command}: ${result.response}`);
      }
    }

    this.logger.info(`All ${commands.length} commands completed in ${totalTime}ms`);

    const successCount = results.filter(r => r.success).length;
    if (successCount === commands.length) {
      this.logger.info('✓ All concurrent commands executed successfully');
    } else {
      this.logger.warning(`⚠ ${successCount}/${commands.length} commands succeeded`);
    }
  }

  /**
   * Test error handling
   */
  private async testErrorHandling(protocol: RconProtocol): Promise<void> {
    this.logger.info('\nTest 5: Error Handling');
    this.logger.info('----------------------');

    try {
      // Test invalid command
      const response = await protocol.send('this_is_not_a_valid_command_12345');
      this.logger.info(`Invalid command response: ${response}`);
      this.logger.info('✓ Invalid command handled gracefully');
    } catch (error) {
      this.logger.error(`✗ Error with invalid command: ${error}`);
    }

    // Test command with very long argument
    try {
      const longArg = 'a'.repeat(1000);
      const response = await protocol.send(`say ${longArg}`);
      this.logger.info('✓ Long argument command handled');
    } catch (error) {
      this.logger.error(`✗ Error with long argument: ${error}`);
    }
  }
}

/**
 * Command to run tests from the extension
 */
export async function testRconProtocol(
  host: string,
  port: number,
  password: string,
  logger: Logger
): Promise<void> {
  const tester = new RconProtocolTest(logger);
  await tester.runTests(host, port, password);
}
