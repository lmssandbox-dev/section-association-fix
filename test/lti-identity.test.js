'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extractLtiIdentity}=require('../src/shared/ltiIdentity');

test('LTI identity uses only the ltijs validated userInfo projection and bounds values',()=>{
 assert.deepEqual(extractLtiIdentity({user:'numeric-looking-sub',userInfo:{name:'Ada Lovelace',given_name:'A',family_name:'L',email:'ada@example.test'}}),{fullName:'Ada Lovelace',orgDefinedId:'',userId:''});
 assert.deepEqual(extractLtiIdentity({userInfo:{given_name:'Ada',family_name:'Lovelace'}}),{fullName:'Ada Lovelace',orgDefinedId:'',userId:''});
 assert.deepEqual(extractLtiIdentity({user:'subject-only'}),{fullName:'',orgDefinedId:'',userId:''});
 assert.equal(extractLtiIdentity({userInfo:{name:'x'.repeat(300)}}).fullName.length,256);
});
