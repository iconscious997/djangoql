(function (DjangoQL) {
  'use strict';

  DjangoQL.DOMReady(function () {
    // Replace standard search input with textarea
    var textarea;
    var input = document.querySelector('input[name=q]');
    if (!input) {
      return;
    }
    textarea = document.createElement('textarea');
    textarea.value = input.value;
    textarea.id = input.id;
    textarea.name = input.name;
    textarea.setAttribute('maxlength', 2000);
    input.parentNode.insertBefore(textarea, input);
    input.parentNode.removeChild(input);
    textarea.focus();

    DjangoQL.init({
      introspections: 'introspect/',
      selector: 'textarea[name=q]',
      autoresize: true
    });
  });
}(window.DjangoQL));
