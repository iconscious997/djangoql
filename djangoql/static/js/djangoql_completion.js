(function (root, factory) {
  'use strict';

  /* global define, require */

  if (typeof define === 'function' && define.amd) {
    // AMD. Register as an anonymous module.
    define('DjangoQL', ['Lexer'], factory);
  } else if (typeof exports === 'object') {
    // Node. Does not work with strict CommonJS, but
    // only CommonJS-like environments that support module.exports,
    // like Node.
    module.exports = factory(require('Lexer'));  // eslint-disable-line
  } else {
    // Browser globals (root is window)
    root.DjangoQL = factory(root.Lexer);  // eslint-disable-line
  }
}(this, function (Lexer) {
  'use strict';

  var reIntValue = '(-?0|-?[1-9][0-9]*)';
  var reFractionPart = '\\.[0-9]+';
  var reExponentPart = '[eE][+-]?[0-9]+';
  var intRegex = new RegExp(reIntValue);
  var floatRegex = new RegExp(
      reIntValue + reFractionPart + reExponentPart + '|' +
      reIntValue + reFractionPart + '|' +
      reIntValue + reExponentPart);
  var reLineTerminators = '\\n\\r\\u2028\\u2029';
  var reEscapedChar = '\\\\[\\\\"/bfnrt]';
  var reEscapedUnicode = '\\\\u[0-9A-Fa-f]{4}';
  var reStringChar = '[^\\"\\\\' + reLineTerminators + ']';
  var stringRegex = new RegExp(
      '\\"(' + reEscapedChar +
      '|' + reEscapedUnicode +
      '|' + reStringChar + ')*\\"');
  var nameRegex = /[_A-Za-z][_0-9A-Za-z]*(\.[_A-Za-z][_0-9A-Za-z]*)*/;
  var reNotFollowedByName = '(?![_0-9A-Za-z])';
  var whitespaceRegex = /[ \t\v\f\u00A0]+/;

  var lexer = new Lexer(function () {
    // Silently swallow any lexer errors
  });

  function token(name, value) {
    return { name: name, value: value };
  }

  lexer.addRule(whitespaceRegex, function () { /* ignore whitespace */ });
  lexer.addRule(/\./, function (l) { return token('DOT', l); });
  lexer.addRule(/,/, function (l) { return token('COMMA', l); });
  lexer.addRule(new RegExp('or' + reNotFollowedByName), function (l) {
    return token('OR', l);
  });
  lexer.addRule(new RegExp('and' + reNotFollowedByName), function (l) {
    return token('AND', l);
  });
  lexer.addRule(new RegExp('not' + reNotFollowedByName), function (l) {
    return token('NOT', l);
  });
  lexer.addRule(new RegExp('in' + reNotFollowedByName), function (l) {
    return token('IN', l);
  });
  lexer.addRule(new RegExp('True' + reNotFollowedByName), function (l) {
    return token('TRUE', l);
  });
  lexer.addRule(new RegExp('False' + reNotFollowedByName), function (l) {
    return token('FALSE', l);
  });
  lexer.addRule(new RegExp('None' + reNotFollowedByName), function (l) {
    return token('NONE', l);
  });
  lexer.addRule(nameRegex, function (l) { return token('NAME', l); });
  lexer.addRule(stringRegex, function (l) {
    // Trim leading and trailing quotes
    return token('STRING_VALUE', l.slice(1, l.length - 1));
  });
  lexer.addRule(intRegex, function (l) { return token('INT_VALUE', l); });
  lexer.addRule(floatRegex, function (l) { return token('FLOAT_VALUE', l); });
  lexer.addRule(/\(/, function (l) { return token('PAREN_L', l); });
  lexer.addRule(/\)/, function (l) { return token('PAREN_R', l); });
  lexer.addRule(/=/, function (l) { return token('EQUALS', l); });
  lexer.addRule(/!=/, function (l) { return token('NOT_EQUALS', l); });
  lexer.addRule(/>/, function (l) { return token('GREATER', l); });
  lexer.addRule(/>=/, function (l) { return token('GREATER_EQUAL', l); });
  lexer.addRule(/</, function (l) { return token('LESS', l); });
  lexer.addRule(/<=/, function (l) { return token('LESS_EQUAL', l); });
  lexer.addRule(/~/, function (l) { return token('CONTAINS', l); });
  lexer.addRule(/!~/, function (l) { return token('NOT_CONTAINS', l); });
  lexer.lexAll = function () {
    var match;
    var result = [];
    while (match = this.lex()) {  // eslint-disable-line no-cond-assign
      match.start = this.index - match.value.length;
      match.end = this.index;
      result.push(match);
    }
    return result;
  };

  // Main DjangoQL object
  return {
    currentModel: null,
    models: {},

    token: token,
    lexer: lexer,

    prefix: '',
    suggestions: [],
    selected: null,

    textarea: null,
    completion: null,
    completionUL: null,

    init: function (options) {
      // Initialization
      if (!this.isObject(options)) {
        this.logError('Please pass an object with initialization parameters');
        return;
      }
      this.loadIntrospections(options.introspections);
      this.textarea = document.querySelector(options.selector);
      if (!this.textarea) {
        this.logError('Element not found by selector: ' + options.selector);
        return;
      }
      if (this.textarea.tagName !== 'TEXTAREA') {
        this.logError('selector must be pointing to <textarea> element, but ' +
            this.textarea.tagName + ' was found');
        return;
      }

      // Bind event handlers and initialize completion & textSize containers
      this.textarea.setAttribute('autocomplete', 'off');
      this.textarea.addEventListener('keydown', this.onKeydown.bind(this));
      this.textarea.addEventListener('blur', this.hideCompletion.bind(this));
      if (options.autoresize) {
        this.textarea.style.resize = 'none';
        this.textarea.style.overflow = 'hidden';
        this.textarea.addEventListener('input', this.textareaResize.bind(this));
      } else {
        // Catch resize events and re-position completion box.
        // See http://stackoverflow.com/a/7055239
        this.textarea.addEventListener(
            'mouseup', this.renderCompletion.bind(this, true));
        this.textarea.addEventListener(
            'mouseout', this.renderCompletion.bind(this, true));
      }

      this.completion = document.createElement('div');
      this.completion.className = 'djangoql-completion';
      document.querySelector('body').appendChild(this.completion);
      this.completionUL = document.createElement('ul');
      this.completion.appendChild(this.completionUL);

      // .renderCompletion() re-uses these handlers many times when adding and
      // removing event listeners, so it's handy to have them already bound
      this.onCompletionMouseClick = this.onCompletionMouseClick.bind(this);
      this.onCompletionMouseDown = this.onCompletionMouseDown.bind(this);
      this.onCompletionMouseOut = this.onCompletionMouseOut.bind(this);
      this.onCompletionMouseOver = this.onCompletionMouseOver.bind(this);
    },

    loadIntrospections: function (introspections) {
      var onLoadError;
      var request;
      if (typeof introspections === 'string') {
        // treat as URL
        onLoadError = function () {
          this.logError('failed to load introspections from ' + introspections);
        }.bind(this);
        request = new XMLHttpRequest();
        request.open('GET', introspections, true);
        request.onload = function () {
          var data;
          if (request.status === 200) {
            data = JSON.parse(request.responseText);
            this.currentModel = data.current_model;
            this.models = data.models;
          } else {
            onLoadError();
          }
        }.bind(this);
        request.ontimeout = onLoadError;
        request.onerror = onLoadError;
        /* eslint-disable max-len */
        // Workaround for IE9, see
        // https://cypressnorth.com/programming/internet-explorer-aborting-ajax-requests-fixed/
        /* eslint-enable max-len */
        request.onprogress = function () {};
        window.setTimeout(request.send.bind(request));
      } else if (this.isObject(introspections)) {
        this.currentModel = introspections.current_model;
        this.models = introspections.models;
      } else {
        this.logError(
            'introspections parameter is expected to be either URL or ' +
            'object with definitions, but ' + introspections + ' was found');
      }
    },

    isObject: function (obj) {
      return (({}).toString.call(obj) === '[object Object]');
    },

    logError: function (message) {
      console.error('DjangoQL: ' + message);  // eslint-disable-line no-console
    },

    DOMReady: function (callback) {
      if (document.readyState !== 'loading') {
        callback();
      } else {
        document.addEventListener('DOMContentLoaded', callback);
      }
    },

    onCompletionMouseClick: function (e) {
      this.selectCompletion(parseInt(e.target.getAttribute('data-index'), 10));
    },

    onCompletionMouseDown: function (e) {
      // This is needed to prevent 'blur' event on textarea
      e.preventDefault();
    },

    onCompletionMouseOut: function () {
      this.selected = null;
      this.renderCompletion();
    },

    onCompletionMouseOver: function (e) {
      this.selected = parseInt(e.target.getAttribute('data-index'), 10);
      this.renderCompletion();
    },

    onKeydown: function (e) {
      switch (e.keyCode) {
        case 38:  // up arrow
          if (this.suggestions.length) {
            if (this.selected === null) {
              this.selected = this.suggestions.length - 1;
            } else if (this.selected === 0) {
              this.selected = null;
            } else {
              this.selected -= 1;
            }
            this.renderCompletion();
            e.preventDefault();
          }
          break;

        case 40:  // down arrow
          if (this.suggestions.length) {
            if (this.selected === null) {
              this.selected = 0;
            } else if (this.selected < this.suggestions.length - 1) {
              this.selected += 1;
            } else {
              this.selected = null;
            }
            this.renderCompletion();
            e.preventDefault();
          }
          break;

        case 9:   // Tab
          if (this.selected !== null) {
            this.selectCompletion(this.selected);
            e.preventDefault();
          }
          break;

        case 13:  // Enter
          if (this.selected !== null) {
            this.selectCompletion(this.selected);
          } else {
            // Technically this is a textarea, due to automatic multi-line
            // feature, but other than that it should look and behave like
            // a normal input. So expected behavior when pressing Enter is
            // to submit the form, not to add a new line.
            e.target.form.submit();
          }
          e.preventDefault();
          break;

        case 27:  // Esc
          this.hideCompletion();
          break;

        default:
          // When keydown is fired input value has not been updated yet,
          // so we need to wait
          window.setTimeout(function (input) {
            this.generateSuggestions(input);
            this.selected = null;
            this.renderCompletion();
          }.bind(this, e.target));
          break;
      }
    },

    textareaResize: function () {
      // Automatically grow/shrink textarea to have the contents always visible
      var style = window.getComputedStyle(this.textarea, null);
      var heightOffset = parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom);
      this.textarea.style.height = '5px';
      // dirty hack, works for Django admin styles only.
      // Ping me if you know how to get rid of "+1"
      this.textarea.style.height = (this.textarea.scrollHeight - heightOffset) +
          1 + 'px';
    },

    selectCompletion: function (index) {
      var startPos = this.textarea.selectionStart;
      var textAfter = this.textarea.value.slice(startPos);
      var textBefore = this.textarea.value.slice(0, startPos);
      var textToPaste = this.suggestions[index].slice(this.prefix.length);
      var cursorPosAfter = textBefore.length + textToPaste.length;
      this.textarea.value = textBefore + textToPaste + textAfter;
      this.textarea.focus();
      this.textarea.setSelectionRange(cursorPosAfter, cursorPosAfter);
      // Just calling .hideCompletion() here is not enough for mouse clicks,
      // we need to clear them explicitly.
      this.suggestions = [];
      this.renderCompletion();
    },

    hideCompletion: function () {
      this.selected = null;
      if (this.completion) {
        this.completion.style.display = 'none';
      }
    },

    renderCompletion: function (dontForceDisplay) {
      var currentLi;
      var i;
      var inputRect;
      var li;
      var liLen;
      var suggestionsLen;

      if (dontForceDisplay && this.completion.style.display === 'none') {
        return;
      }
      if (!this.suggestions.length) {
        this.hideCompletion();
        return;
      }

      suggestionsLen = this.suggestions.length;
      li = [].slice.call(this.completionUL.querySelectorAll('li'));
      liLen = li.length;

      // Update or create necessary elements
      for (i = 0; i < suggestionsLen; i++) {
        if (i < liLen) {
          currentLi = li[i];
        } else {
          currentLi = document.createElement('li');
          currentLi.setAttribute('data-index', i);
          this.completionUL.appendChild(currentLi);
          currentLi.addEventListener('click', this.onCompletionMouseClick);
          currentLi.addEventListener('mousedown', this.onCompletionMouseDown);
          currentLi.addEventListener('mouseout', this.onCompletionMouseOut);
          currentLi.addEventListener('mouseover', this.onCompletionMouseOver);
        }
        currentLi.innerHTML = '<b>' + this.prefix + '</b>' +
            this.suggestions[i].slice(this.prefix.length);
        currentLi.className = (i === this.selected) ? 'active' : '';
      }
      // Remove redundant elements
      while (liLen > suggestionsLen) {
        liLen--;
        li[liLen].removeEventListener('click', this.onCompletionMouseClick);
        li[liLen].removeEventListener('mousedown', this.onCompletionMouseDown);
        li[liLen].removeEventListener('mouseout', this.onCompletionMouseOut);
        li[liLen].removeEventListener('mouseover', this.onCompletionMouseOver);
        this.completionUL.removeChild(li[liLen]);
      }

      inputRect = this.textarea.getBoundingClientRect();
      this.completion.style.top = inputRect.top + inputRect.height + 'px';
      this.completion.style.left = inputRect.left + 'px';
      this.completion.style.display = 'block';
    },

    resolveName: function (name) {
      // Walk through introspection definitions and get target model and field
      var f;
      var i;
      var l;
      var nameParts = name.split('.');
      var model = this.currentModel;
      var field = null;

      if (model) {
        for (i = 0, l = nameParts.length; i < l; i++) {
          f = this.models[model][nameParts[i]];
          if (!f) {
            model = null;
            field = null;
            break;
          } else if (f.type === 'relation') {
            model = f.relation;
            field = null;
          } else {
            field = nameParts[i];
          }
        }
      }
      return { model: model, field: field };
    },

    getContext: function (text, cursorPos) {
      // This function returns an object with the following 4 properties:
      var prefix;        // text already entered by user in the current scope
      var scope = null;  // 'field', 'comparison', 'value', 'logical' or null
      var model = null;  // model, set for 'field', 'comparison' and 'value'
      var field = null;  // field, set for 'comparison' and 'value'

      var whitespace;
      var nameParts;
      var resolvedName;
      var lastToken = null;
      var nextToLastToken = null;
      var tokens = this.lexer.setInput(text.slice(0, cursorPos)).lexAll();
      if (tokens.length && tokens[tokens.length - 1].end >= cursorPos) {
        // if cursor is positioned on the last token then remove it.
        // We are only interested in tokens preceding current.
        tokens.pop();
      }
      if (tokens.length) {
        lastToken = tokens[tokens.length - 1];
        if (tokens.length > 1) {
          nextToLastToken = tokens[tokens.length - 2];
        }
      }

      // Current token which is currently being typed may be not complete yet,
      // so lexer may fail to recognize it correctly. So we define current token
      // prefix as a string without whitespace positioned after previous token
      // and until current cursor position.
      prefix = text.slice(lastToken ? lastToken.end : 0, cursorPos);
      whitespace = prefix.match(whitespaceRegex);
      if (whitespace) {
        prefix = prefix.slice(whitespace[0].length);
      }
      if (prefix === '(') {
        // Paren should not be a part of suggestion
        prefix = '';
      }

      if (prefix === ')' && !whitespace) {
        // Nothing to suggest right after right paren
      } else if (!lastToken ||
          (['AND', 'OR'].indexOf(lastToken.name) >= 0 && whitespace) ||
          (prefix === '.' && lastToken && !whitespace) ||
          (lastToken.name === 'PAREN_L' && (!nextToLastToken ||
              ['AND', 'OR'].indexOf(nextToLastToken.name) >= 0))) {
        scope = 'field';
        model = this.currentModel;
        if (prefix === '.') {
          prefix = text.slice(lastToken.start, cursorPos);
        }
        nameParts = prefix.split('.');
        if (nameParts.length > 1) {
          // use last part as a prefix, analyze preceding parts to get the model
          prefix = nameParts.pop();
          resolvedName = this.resolveName(nameParts.join('.'));
          if (resolvedName.model && !resolvedName.field) {
            model = resolvedName.model;
          } else {
            // if resolvedName.model is null that means that model wasn't found.
            // if resolvedName.field is NOT null that means that the name
            // preceding current prefix is a concrete field and not a relation,
            // and therefore it can't have any properties.
            scope = null;
            model = null;
          }
        }
      } else if (lastToken && whitespace &&
          nextToLastToken && nextToLastToken.name === 'NAME' &&
          ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS', 'GREATER_EQUAL',
            'GREATER', 'LESS_EQUAL', 'LESS'].indexOf(lastToken.name) >= 0) {
        resolvedName = this.resolveName(nextToLastToken.value);
        if (resolvedName.model) {
          scope = 'value';
          model = resolvedName.model;
          field = resolvedName.field;
        }
      } else if (lastToken && whitespace && lastToken.name === 'NAME') {
        resolvedName = this.resolveName(lastToken.value);
        if (resolvedName.model) {
          scope = 'comparison';
          model = resolvedName.model;
          field = resolvedName.field;
        }
      } else if (lastToken && whitespace &&
          ['PAREN_R', 'INT_VALUE', 'FLOAT_VALUE', 'STRING_VALUE']
              .indexOf(lastToken.name) >= 0) {
        scope = 'logical';
      }
      return { prefix: prefix, scope: scope, model: model, field: field };
    },

    generateSuggestions: function (input) {
      var context;

      if (input.selectionStart !== input.selectionEnd) {
        // We shouldn't show suggestions when something is selected
        this.prefix = '';
        this.suggestions = [];
        return;
      }

      context = this.getContext(input.value, input.selectionStart);
      this.prefix = context.prefix;
      switch (context.scope) {
        case 'field':
          this.suggestions = Object.keys(this.models[context.model]);
          break;

        case 'comparison':
          this.suggestions = ['=', '!='];
          if (context.field && context.field.type !== 'bool') {
            if (context.field.type === 'str') {
              this.suggestions.push('~');
              this.suggestions.push('!~');
            }
            Array.prototype.push.apply(
                this.suggestions,
                ['>', '>=', '<', '<=', 'in', 'not in']);
          }
          break;

        case 'logical':
          this.suggestions = ['and', 'or'];
          break;

        default:
          this.prefix = '';
          this.suggestions = [];
      }
      this.suggestions = this.suggestions.filter(function (item) {
        // See http://stackoverflow.com/a/4579228
        return item.lastIndexOf(this.prefix, 0) === 0;
      }.bind(this));
    }

  };
}));
