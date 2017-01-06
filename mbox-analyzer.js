#!/usr/bin/env node
'use strict';

const IGNORED_SENDERS = /^no-?reply@.+$/;

const Mbox = require('node-mbox');
const csv = require('csv-parse/lib/sync');
const MailParser = require('mailparser').MailParser;
const moment = require('moment-business-days');
const sparkly = require('sparkly');
const fs = require('fs');
const util = require('util');

function parseMessage(raw_msg) {
  return new Promise((resolve, reject) => {
    let mailparser = new MailParser();
    mailparser.on('end', (msg) => {
      resolve({
        from:    msg.from[0],
        to:      msg.to,
        subject: msg.subject,
        date:    msg.date,
        text:    msg.text
      });
    });
    mailparser.on('error', (err) => reject(err));
    mailparser.write(raw_msg);
    mailparser.end();
  });
}

function loadMessagesInfo(mbox_filename) {
  return new Promise((resolve, reject) => {
    let messages = [];
    let mbox = new Mbox(mbox_filename);
    mbox.on('message', (raw_msg) => {
      parseMessage(raw_msg).
        then((parsed_message) => messages.push(parsed_message));
    });
    mbox.on('end', () => resolve(messages));
    mbox.on('error', (err) => reject(err));
  });
}

function loadContactsInfo(contacts_filename) {
  if (!contacts_filename)
    return {};

  let records = csv(fs.readFileSync(contacts_filename, 'utf16le'), {trim: true});
  let contacts = {};
  for (let person of records) {
    let name = person[0];
    for (let field of person) {
      if (field.match(/^\S+@\S+\.\S+$/)) {
        contacts[field] = name;
      }
    }
  }
  return contacts;
}

function ignoreFrom(from) {
  return from && from.match(IGNORED_SENDERS);
}

function ignoreSubject(subject) {
  return subject && subject.match(/^RE:/i);
}

function isReportMessage(msg) {
  if (ignoreFrom(msg.from.address))
    return false;
  if (ignoreSubject(msg.subject))
    return false;
  return true;
}

function filterMessages(messages) {
  return messages.filter((msg) => isReportMessage(msg));
}

function getReportsByAuthor(messages, contacts) {
  let authors = {};
  for (let msg of filterMessages(messages)) {
    let key = contacts[msg.from.address] || msg.from.address;
    if (!authors[key])
      authors[key] = [];
    authors[key].push(msg);
  }
  return authors;
}

function calcWorkDays() {
  return moment().monthBusinessDays().length;
}

function getSpan(reports) {
  let span = {};
  for (let i = 1; i <= 31; i++) {
    span[i] = {size: 0, count: 0};
  }
  for (let msg of reports) {
    let key = moment(msg.date).date(); // day of month
    span[key].count += 1;
    span[key].size += msg.text ? msg.text.length : 0;
  }
  return span;
}

function getSparklineFromSpan(span, key) {
  let data = [];
  for (let k in span) {
    data.push(span[k][key]);
  }
  return sparkly(data);
}

function dumpStats(messages, contacts) {
  let stats = prepareStats(messages, contacts);
  for (let s of stats) {
    dumpS(s);
  }
}

function dumpS(s) {
  console.log('Author:', s.author);
  console.log(util.format('Messages: %s, daily ratio: %d%%', s.count, Math.trunc(s.ratio * 100)));
  console.log('Messages amount distribution:', s.sparklines.count);
  console.log('Messages size distribution:  ', s.sparklines.size);
  console.log('');
}

function prepareStats (messages, contacts) {
  let reports = getReportsByAuthor(messages, contacts);
  let workDays = calcWorkDays();
  let stats = [];
  for (let a in reports) {
    let span = getSpan(reports[a]);
    stats.push({
      author: a,
      span: span,
      count: reports[a].length,
      ratio: reports[a].length / workDays,
      sparklines: {
        count: getSparklineFromSpan(span, 'count'),
        size: getSparklineFromSpan(span, 'size'),
      }
    });
  }
  let cmp = (a, b) => {
    return a > b ? 1 : (b > a ? -1 : 0);
  };

  return stats.sort((a, b) => cmp(a.ratio, b.ratio));
}

var mbox_filename = process.argv[2];
var contacts_filename = process.argv[3];
if (!mbox_filename)
  throw "No mbox filename given";
if (!contacts_filename)
  console.log("No contacts filename given - working without it...");

var contacts;
try {
  contacts = loadContactsInfo(contacts_filename);
} catch (err) {
  throw err;
}

loadMessagesInfo(mbox_filename)
  .then((messages) => {
    try {
      dumpStats(messages, contacts);
    } catch (e) {
      console.log(e.stack);
    }
  })
  .catch((err) => {
    throw err;
  });