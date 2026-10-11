const theme = { typography: { size: { regular: 14 } } };
const face = theme.typography.fontFamily.regular; // deliberate missing key, crashes at startup
console.log(face);
