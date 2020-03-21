const tailwindcss = require('tailwindcss');

const purgecss = require('@fullhuman/postcss-purgecss')({
  // Specify the paths to all of the template files in your project
  content: [
    './static/**/*.svelte',
    './static/**/*.js',
    './static/**/*.ts',
    // etc.
  ],

  // Include any special characters you're using in this regular expression
  defaultExtractor: content => content.match(/[\w-/:]+(?<!:)/g) || [],
});
module.exports = {
  plugins: [
    tailwindcss,
    ...(process.env.NODE_ENV === 'development' ? [] : [purgecss]),
  ],
};
