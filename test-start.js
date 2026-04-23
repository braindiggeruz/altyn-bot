// Test script to simulate /start handler locally and find errors
import { createUser, getUser, updateUser, logMessage, logEvent, initDatabase, pool } from './src/database.js';

const TEST_CHAT_ID = 6576554366;

async function testStartHandler() {
  console.log('=== Testing /start handler logic ===\n');
  
  try {
    // Step 0: Init database
    console.log('Step 0: Init database...');
    await initDatabase();
    console.log('✅ Database initialized\n');
    
    // Step 1: createUser
    console.log('Step 1: createUser...');
    const user = await createUser({
      telegram_id: TEST_CHAT_ID,
      username: 'testuser',
      first_name: 'Test',
      last_name: 'User',
      source: 'organic'
    });
    console.log('✅ createUser result:', user ? 'exists' : 'created');
    console.log('');
    
    // Step 2: getUser
    console.log('Step 2: getUser...');
    const existingUser = await getUser(TEST_CHAT_ID);
    console.log('✅ getUser result:', existingUser ? `found (booking_status: ${existingUser.booking_status})` : 'not found');
    const alreadyBooked = existingUser && ['booked', 'confirmed', 'completed'].includes(existingUser.booking_status);
    console.log('   alreadyBooked:', alreadyBooked);
    console.log('');
    
    // Step 3: updateUser
    console.log('Step 3: updateUser...');
    if (alreadyBooked) {
      console.log('   Path: alreadyBooked');
      const fields = {
        last_active: new Date().toISOString(),
        referred_by: undefined,
      };
      // Simulate the updateUser logic
      const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
      console.log('   Keys:', keys);
      console.log('   ⚠️ PROBLEM: last_active is in fields AND will be added by updateUser!');
      
      try {
        await updateUser(TEST_CHAT_ID, fields);
        console.log('✅ updateUser succeeded (despite duplicate last_active)');
      } catch (err) {
        console.error('❌ updateUser FAILED:', err.message);
      }
    } else {
      console.log('   Path: new/reset user');
      const fields = {
        funnel_stage: 'started',
        quiz_answers: null,
        quiz_score: 0,
        scenario: null,
        warmup_day: 0,
        warmup_active: 1,
        booking_status: 'none',
        booking_name: null,
        booking_request: null,
        booking_time: null,
        referred_by: undefined,
      };
      try {
        await updateUser(TEST_CHAT_ID, fields);
        console.log('✅ updateUser succeeded');
      } catch (err) {
        console.error('❌ updateUser FAILED:', err.message);
      }
    }
    console.log('');
    
    // Step 4: trackReferral (test dynamic import)
    console.log('Step 4: Test trackReferral import...');
    try {
      const mod = await import('./src/database.js');
      if (typeof mod.trackReferral === 'function') {
        console.log('✅ trackReferral exists');
      } else {
        console.log('❌ trackReferral is NOT a function! Type:', typeof mod.trackReferral);
        console.log('   Available exports:', Object.keys(mod).join(', '));
      }
    } catch (e) {
      console.error('❌ Dynamic import error:', e.message);
    }
    console.log('');
    
    // Step 5: logMessage
    console.log('Step 5: logMessage...');
    try {
      await logMessage(TEST_CHAT_ID, 'out', 'welcome', 'Welcome message sent');
      console.log('✅ logMessage succeeded');
    } catch (err) {
      console.error('❌ logMessage FAILED:', err.message);
    }
    console.log('');
    
    // Step 6: logEvent
    console.log('Step 6: logEvent...');
    try {
      await logEvent('test_start', TEST_CHAT_ID, {});
      console.log('✅ logEvent succeeded');
    } catch (err) {
      console.error('❌ logEvent FAILED:', err.message);
    }
    
    console.log('\n=== Test complete ===');
    
  } catch (err) {
    console.error('\n❌ FATAL ERROR:', err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
}

testStartHandler();
